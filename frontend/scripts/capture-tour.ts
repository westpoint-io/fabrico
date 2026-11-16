// capture-tour.ts - the pictures on the docs page "A tour of the app", taken from the real app.
//
// The tour page shows the palette, the inspector, the toolbar and the camera. Those pictures have
// to be the app as it is, so this script runs the same frontend and engine the desktop app runs:
// it starts the dev host (`dev_render_server`, the engine behind a WebSocket on 8787) and the Vite
// dev server on 5173, opens the frontend in Playwright's Chromium at 1440 x 900 CSS px with a
// device scale of 2, loads the demo board through Examples so the run starts again at tick 0,
// holds it on a fixed tick with Step, and takes each picture.
//
// It writes eight PNGs to `site/src/assets/tour/`: overview, inspector, palette, toolbar-run and
// toolbar-file with the first Factory selected, then camera-default with nothing selected, and
// camera-zoomed and camera-controls after two wheel notches and a drag. The site's <Screenshot>
// component reads them from there while it builds. Crops are rounded out to whole CSS px first, so
// their 2x files have even sides.
//
// It exits non-zero, naming the file, when:
// - port 8787 or 5173 already answers (it starts its own servers and won't share them),
// - a full-window picture isn't 2880 x 1800 pixels, or a crop has an odd side or differs by more
//   than 2 px from twice the CSS box it measured in the same run,
// - one colour covers more than 95 percent of a picture (a blank capture),
// - a full-window picture's board didn't draw: the cells the board's machines and belts cover
//   aren't clearly busier than empty floor cells (an empty canvas inside a full app window passes
//   the one-colour check, since the toolbar and panels still draw),
// - the page threw, or a render packet failed to apply, while taking a picture,
// - the render loop wasn't finishing frames when a picture was taken.
// It doesn't compare the pictures with the committed ones: a picture of a changed app is a new
// picture, and the person who commits it looks at it.
//
// It kills only the two process groups it started: in a `finally` on a normal exit or a thrown
// error, and from SIGINT, SIGTERM and SIGHUP handlers (exit 130, 143, 129) when it is stopped,
// because both children run in their own process group and a Ctrl+C never reaches them. A child
// that fails to start (an 'error' event, say a host binary that can't be run) or exits before its
// port answers fails the run with its own message, and the same cleanup runs.
//
// NO PATH INPUT. Every path comes from this file's own location, so it runs the same from the
// repo root and from `frontend/`. Erasure-only TypeScript, so Node runs it as it is. The live
// suite's oracle (`e2e-live/support/oracle.ts`) can't be imported outside the test runner, so the
// two render-health checks it would give are copied here in their own small form.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const OUT_DIR = path.join(REPO, 'site', 'src', 'assets', 'tour');
const HOST_BIN = path.join(REPO, 'target', 'debug', 'examples', 'dev_render_server');
const VITE_BIN = path.join(FRONTEND, 'node_modules', 'vite', 'bin', 'vite.js');

const LOOPBACK = '127.0.0.1';
const VITE_PORT = 5173;
const HOST_PORT = 8787;
const APP_URL = `http://${LOOPBACK}:${VITE_PORT}/`;

/** The window the pictures are taken in, in CSS px, and the device scale (pictures are 2x). */
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;
/** A full-window picture's size in pixels. */
const FULL = { width: 2880, height: 1800 };
/** A crop may differ from twice its measured CSS box by this many pixels. */
const CROP_SLACK_PX = 2;
/** A picture where one colour covers more than this share of the pixels is blank. */
const BLANK_PERCENT = 95;
/**
 * The board check on a full-window picture. Each grid cell on screen that no panel covers is
 * trimmed by BOARD_INSET of its side on every edge (so the floor's grid lines stay out), and its
 * pixels are counted as floor when their summed RGB distance from the floor colour (the most
 * common colour in empty cells) is at most FLOOR_TOLERANCE. The board drew when the cells its
 * machines and belts cover have at least BOARD_MIN_LIFT percentage points more non-floor pixels
 * than empty cells, over at least BOARD_MIN_CELLS such cells.
 */
const BOARD_INSET = 0.2;
const FLOOR_TOLERANCE = 30;
const BOARD_MIN_LIFT = 10;
const BOARD_MIN_CELLS = 8;
/** How many cells past the board's outermost machine or belt count as floor for the board check. */
const BOARD_FLOOR_MARGIN = 3;

/**
 * The tick every picture shows. The demo boots one command per tick and has all 67 commands in by
 * tick 67; by tick 240 orders are on the belts. The script lets the board run to a hold tick, then
 * presses Step until the board stands on TOUR_TICK, so each run shows the same tick whatever the
 * machine's speed.
 *
 * Step reaches the host a little after the page reads the hold tick, and the host plays on in the
 * meantime: about 3 ticks locally, 43 on a slow CI runner, over 100 on one core at a 25% quota. When
 * the board stops past TOUR_TICK the script loads the demo again and holds from the next, earlier
 * tick in HOLD_FROM. Every hold tick is past 67, so the demo has all its commands in. The engine is
 * deterministic, so tick 240 shows the same board whichever hold tick got there.
 */
const TOUR_TICK = 240;
const HOLD_FROM = [200, 160, 100] as const;

/** The toolbar crops reach this many CSS px past the button they end or start at. */
const TOOLBAR_MARGIN = 8;
/** The zoom the camera pictures show: two wheel notches of this deltaY at the window centre. */
const WHEEL_DELTA = -200;
const WHEEL_NOTCHES = 2;
/** The left drag that moves the view for camera-zoomed.png, in CSS px. */
const PAN = { dx: -240, dy: -80 };

/** The GL arguments every browser check in this repo launches Chromium with. */
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader'];
/** The line the packet pipeline logs when a render packet fails to apply (oracle.ts). */
const PACKET_HANDLER_FAILED = 'packet handler failed';
/** The flag the welcome card sets once it has been seen; set first so it never covers the app. */
const ONBOARDING_FLAG = 'fab.onboarding.seen.v1';
/** The Examples entry that loads the demo board, by its title. */
const DEMO_ENTRY_TITLE = 'Load the demo scene and watch the engine run';
/** One grid cell's side in world px (`shared/geometry.ts` CELL). */
const CELL = 32;
/** The Factory machine kind (fabrico-protocol `machine_kind`). */
const FACTORY_KIND = 2;

const BOOT_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 60_000;

type Box = { x: number; y: number; width: number; height: number };
type SceneRead = {
  tick: number;
  generation: number;
  nodes: { id: number; kind: number; cells: [number, number][] }[];
  belts: { tiles: { cell_x: number; cell_y: number }[] }[];
  wires: { path: { cell_x: number; cell_y: number }[] }[];
};
type Camera = { x: number; y: number; scale: number };

/** A full-window picture, or a crop whose size is checked against the box it was taken from. */
type Shot = { file: string; kind: 'full' } | { file: string; kind: 'crop'; box: Box };
/** The cell boxes, in CSS px, the board check grades: under machines and belts, and empty floor. */
type BoardCells = { occupied: Box[]; empty: Box[] };

class CaptureError extends Error {}

const fail = (message: string): never => {
  throw new CaptureError(`capture:tour: ${message}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Servers ----------------------------------------------------------------

function portAnswers(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect({ host: LOOPBACK, port }, () => {
      sock.end();
      res(true);
    });
    sock.on('error', () => res(false));
    sock.setTimeout(500, () => {
      sock.destroy();
      res(false);
    });
  });
}

async function waitForPort(child: ChildProcess, port: number, what: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!(await portAnswers(port))) {
    const trouble = childTrouble.get(child);
    if (trouble !== undefined) fail(`${what} ${trouble}, so nothing answers on ${LOOPBACK}:${port}.`);
    if (Date.now() > deadline) fail(`${what} didn't start listening on ${LOOPBACK}:${port} within ${BOOT_TIMEOUT_MS} ms.`);
    await sleep(300);
  }
}

/** The two children this run started, so the signal handlers can reach them. */
const started: ChildProcess[] = [];
/** What went wrong with a child before its port answered: a failed spawn or an early exit. */
const childTrouble = new Map<ChildProcess, string>();

/** Kill a detached child's whole process group, and nothing else. */
function killGroup(child: ChildProcess | null): void {
  if (child === null || child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function refuseBusyPorts(): Promise<void> {
  for (const port of [HOST_PORT, VITE_PORT]) {
    if (await portAnswers(port)) {
      fail(`port ${port} on ${LOOPBACK} is already in use. Free it before running capture:tour; the script starts its own host and dev server.`);
    }
  }
}

/** Kill every child this run started. Synchronous, so it also works from an 'exit' handler. */
function killStarted(): void {
  for (const child of started) killGroup(child);
}

/**
 * Remember a child, and turn its 'error' event (a spawn that failed) and an exit before the run
 * ends into a message waitForPort reports. Without the 'error' listener Node throws the event
 * outside main()'s try/finally and the other child is left running.
 */
function track(child: ChildProcess): ChildProcess {
  started.push(child);
  child.on('error', (e) => childTrouble.set(child, `couldn't start (${e.message})`));
  child.on('exit', (code, signal) => {
    if (!childTrouble.has(child)) childTrouble.set(child, `exited early (code ${code}, signal ${signal})`);
  });
  return child;
}

function startHost(): ChildProcess {
  if (!existsSync(HOST_BIN)) {
    fail(`the dev host is missing at ${HOST_BIN}. Build it first: cargo build -p fabrico-host --example dev_render_server`);
  }
  return track(spawn(HOST_BIN, [], { cwd: REPO, detached: true, stdio: 'ignore' }));
}

function startVite(): ChildProcess {
  return track(
    spawn(process.execPath, [VITE_BIN, '--host', LOOPBACK, '--port', String(VITE_PORT), '--strictPort'], {
      cwd: FRONTEND,
      detached: true,
      stdio: 'ignore',
    }),
  );
}

/**
 * Stop both children when the run is stopped. Node's default for these signals ends the process
 * without running a pending `finally`, and the children, each in its own process group, never get
 * the terminal's signal, so without this they keep 8787 and 5173 and the next run refuses to start.
 */
const STOP_SIGNALS: [NodeJS.Signals, number][] = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
];
for (const [signal, code] of STOP_SIGNALS) {
  process.once(signal, () => {
    killStarted();
    console.error(`capture:tour: stopped by ${signal}; killed the dev host and Vite process groups.`);
    process.exit(code);
  });
}
process.on('exit', killStarted);

// --- Page reads -------------------------------------------------------------

const readScene = (page: Page): Promise<SceneRead> =>
  page.evaluate(() => {
    const s = (window as unknown as { __fabrico: { scene(): SceneRead } }).__fabrico.scene();
    return {
      tick: s.tick,
      generation: s.generation,
      nodes: s.nodes.map((n) => ({ id: n.id, kind: n.kind, cells: n.cells })),
      belts: s.belts.map((b) => ({ tiles: b.tiles.map((t) => ({ cell_x: t.cell_x, cell_y: t.cell_y })) })),
      wires: s.wires.map((w) => ({ path: w.path.map((t) => ({ cell_x: t.cell_x, cell_y: t.cell_y })) })),
    };
  });

const readCamera = (page: Page): Promise<Camera> =>
  page.evaluate(() => (window as unknown as { __fabrico: { camera(): Camera } }).__fabrico.camera());

const readTickerTime = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __fabrico: { tickerTime(): number } }).__fabrico.tickerTime());

async function waitUntil<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) fail(`${what}: still not true after ${timeoutMs} ms (last read ${JSON.stringify(last).slice(0, 200)}).`);
    await sleep(50);
    last = await read();
  }
  return last;
}

/** A cell's centre on screen, in CSS px, through the camera. */
function cellCentre(cam: Camera, cx: number, cy: number): { x: number; y: number } {
  return { x: cam.x + (cx * CELL + CELL / 2) * cam.scale, y: cam.y + (cy * CELL + CELL / 2) * cam.scale };
}

/** A box rounded out to whole CSS px, so a 2x picture of it has even sides. */
function wholePx(b: Box): Box {
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  return { x, y, width: Math.ceil(b.x + b.width) - x, height: Math.ceil(b.y + b.height) - y };
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const b = await locator.boundingBox();
  if (b === null) return fail(`${what} isn't on screen, so it can't be measured.`);
  return b;
}

// --- Health and picture checks ---------------------------------------------

/** Page errors and failed render packets since the page opened (the live suite's watchPageErrors). */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().startsWith(PACKET_HANDLER_FAILED)) errors.push(m.text());
  });
  return errors;
}

/**
 * The render loop is alive on a held board (the live suite's expectRenderLoopAlive with
 * boardHeld): the Pixi ticker's last frame time takes at least three distinct values, and the
 * board's tick stays put while it is read.
 */
async function checkRenderLoop(page: Page, file: string, tick: number): Promise<void> {
  const seen = new Set<number>([await readTickerTime(page)]);
  const deadline = Date.now() + 5_000;
  while (seen.size < 3 && Date.now() < deadline) {
    await sleep(50);
    seen.add(await readTickerTime(page));
  }
  if (seen.size < 3) fail(`the render loop stopped while taking ${file}: the Pixi ticker finished ${seen.size - 1} frames in 5 s.`);
  const now = (await readScene(page)).tick;
  if (now !== tick) fail(`the board moved while taking ${file}: it was paused on tick ${tick} and now reads ${now}.`);
}

/**
 * The grid cells on screen that the board check grades, as CSS px boxes trimmed by BOARD_INSET.
 * A cell counts only when the board canvas is the topmost element at its centre and its four
 * corners, so a panel over the board never counts as drawn board.
 */
async function boardCells(page: Page, scene: SceneRead): Promise<BoardCells> {
  const cam = await readCamera(page);
  const drawn = new Set<string>();
  for (const n of scene.nodes) for (const [cx, cy] of n.cells) drawn.add(`${cx},${cy}`);
  for (const b of scene.belts) for (const t of b.tiles) drawn.add(`${t.cell_x},${t.cell_y}`);
  const taken = occupiedCells(scene);
  const xs = [...taken].map((k) => Number(k.split(',')[0]));
  const ys = [...taken].map((k) => Number(k.split(',')[1]));
  if (xs.length === 0) return fail('the board has no machine or belt, so the board check has nothing to grade.');
  const side = CELL * cam.scale;
  const trim = side * BOARD_INSET;
  const candidates: { box: Box; occupied: boolean }[] = [];
  for (let cy = Math.min(...ys) - BOARD_FLOOR_MARGIN; cy <= Math.max(...ys) + BOARD_FLOOR_MARGIN; cy++) {
    for (let cx = Math.min(...xs) - BOARD_FLOOR_MARGIN; cx <= Math.max(...xs) + BOARD_FLOOR_MARGIN; cx++) {
      const key = `${cx},${cy}`;
      // A wire cell is neither: the wire is a thin line the trimmed box can miss.
      if (taken.has(key) && !drawn.has(key)) continue;
      const box = { x: cam.x + cx * side + trim, y: cam.y + cy * side + trim, width: side - 2 * trim, height: side - 2 * trim };
      if (box.x < 0 || box.y < 0 || box.x + box.width > VIEWPORT.width || box.y + box.height > VIEWPORT.height) continue;
      candidates.push({ box, occupied: drawn.has(key) });
    }
  }
  const onCanvas = await page.evaluate(
    (boxes) =>
      boxes.map((b) =>
        [
          [b.x + b.width / 2, b.y + b.height / 2],
          [b.x, b.y],
          [b.x + b.width, b.y],
          [b.x, b.y + b.height],
          [b.x + b.width, b.y + b.height],
        ].every(([x, y]) => document.elementFromPoint(x, y) instanceof HTMLCanvasElement),
      ),
    candidates.map((c) => c.box),
  );
  const cells: BoardCells = { occupied: [], empty: [] };
  candidates.forEach((c, i) => {
    if (onCanvas[i]) (c.occupied ? cells.occupied : cells.empty).push(c.box);
  });
  return cells;
}

type Rgba = { data: Uint8Array | Buffer; width: number };

/** The pixels of a CSS px box in a 2x picture, as [r, g, b] triples. */
function* boxPixels(img: Rgba, box: Box): Generator<[number, number, number]> {
  const x0 = Math.ceil(box.x * SCALE);
  const y0 = Math.ceil(box.y * SCALE);
  const x1 = Math.floor((box.x + box.width) * SCALE);
  const y1 = Math.floor((box.y + box.height) * SCALE);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * img.width + x) * 4;
      yield [img.data[at], img.data[at + 1], img.data[at + 2]];
    }
  }
}

/**
 * Grade the board in a full-window picture: the mean share of non-floor pixels in cells under
 * machines and belts, minus the same share in empty cells, in percentage points. The script
 * calls it on every full-window picture.
 */
function boardLift(img: Rgba, cells: BoardCells): { lift: number; occupied: number; empty: number } {
  const counts = new Map<number, number>();
  for (const box of cells.empty) {
    for (const [r, g, b] of boxPixels(img, box)) {
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let floor = -1;
  let best = 0;
  for (const [key, n] of counts) {
    if (n > best) {
      best = n;
      floor = key;
    }
  }
  const fr = (floor >> 16) & 0xff;
  const fg = (floor >> 8) & 0xff;
  const fb = floor & 0xff;
  const busy = (box: Box): number => {
    let all = 0;
    let off = 0;
    for (const [r, g, b] of boxPixels(img, box)) {
      all++;
      if (Math.abs(r - fr) + Math.abs(g - fg) + Math.abs(b - fb) > FLOOR_TOLERANCE) off++;
    }
    return all === 0 ? 0 : (off / all) * 100;
  };
  const mean = (boxes: Box[]): number => boxes.reduce((sum, b) => sum + busy(b), 0) / Math.max(boxes.length, 1);
  const occupied = mean(cells.occupied);
  const empty = mean(cells.empty);
  return { lift: occupied - empty, occupied, empty };
}

function checkPicture(shot: Shot, png: Buffer, board: BoardCells | null): { width: number; height: number; topPercent: number; lift: number | null } {
  const img = PNG.sync.read(png);
  if (shot.kind === 'full') {
    if (img.width !== FULL.width || img.height !== FULL.height) {
      fail(`${shot.file} is ${img.width} x ${img.height}, expected ${FULL.width} x ${FULL.height}.`);
    }
  } else {
    const want = { width: Math.round(shot.box.width * SCALE), height: Math.round(shot.box.height * SCALE) };
    const odd = img.width % 2 !== 0 || img.height % 2 !== 0;
    const off = Math.abs(img.width - want.width) > CROP_SLACK_PX || Math.abs(img.height - want.height) > CROP_SLACK_PX;
    if (odd || off) fail(`${shot.file} is ${img.width} x ${img.height}, expected ${want.width} x ${want.height}.`);
  }
  // The most common exact colour, as a share of all pixels.
  const pixels = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  const counts = new Map<number, number>();
  let top = 0;
  for (const p of pixels) {
    const c = (counts.get(p) ?? 0) + 1;
    counts.set(p, c);
    if (c > top) top = c;
  }
  const topPercent = (top / pixels.length) * 100;
  if (topPercent > BLANK_PERCENT) fail(`${shot.file} is blank: one colour covers ${topPercent.toFixed(1)}% of it.`);
  if (board === null) return { width: img.width, height: img.height, topPercent, lift: null };
  if (board.occupied.length < BOARD_MIN_CELLS || board.empty.length < BOARD_MIN_CELLS) {
    fail(
      `${shot.file}: only ${board.occupied.length} board cells and ${board.empty.length} floor cells are on screen and clear of the panels; the board check needs ${BOARD_MIN_CELLS} of each.`,
    );
  }
  const graded = boardLift(img, board);
  if (graded.lift < BOARD_MIN_LIFT) {
    fail(
      `${shot.file}: the board didn't draw. Cells under machines and belts are ${graded.occupied.toFixed(1)}% non-floor and empty cells ${graded.empty.toFixed(1)}%, a lift of ${graded.lift.toFixed(1)} points, under ${BOARD_MIN_LIFT}.`,
    );
  }
  return { width: img.width, height: img.height, topPercent, lift: graded.lift };
}

async function take(page: Page, errors: string[], shot: Shot, tick: number): Promise<void> {
  await checkRenderLoop(page, shot.file, tick);
  const board = shot.kind === 'full' ? await boardCells(page, await readScene(page)) : null;
  const png =
    shot.kind === 'full'
      ? await page.screenshot({ animations: 'allow' })
      : await page.screenshot({ clip: shot.box, animations: 'allow' });
  if (errors.length > 0) fail(`the page threw while taking ${shot.file}: ${errors.join('; ')}`);
  const got = checkPicture(shot, png, board);
  writeFileSync(path.join(OUT_DIR, shot.file), png);
  const lift = got.lift === null ? '' : `, board lift ${got.lift.toFixed(1)} points over ${board?.occupied.length} cells`;
  console.log(`capture:tour: wrote ${shot.file} ${got.width} x ${got.height}, top colour ${got.topPercent.toFixed(1)}%${lift}`);
}

// --- The board ----------------------------------------------------------------

/** Load the demo through Examples and wait until it plays again from tick 0. */
async function loadDemo(page: Page, before: SceneRead): Promise<void> {
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByTitle(DEMO_ENTRY_TITLE).click();
  const loaded = await waitUntil(
    'the demo board loads again from tick 0',
    () => readScene(page),
    (s) => s.generation !== before.generation || s.tick < before.tick,
  );
  // A board held with Step may load held. Play it if its tick stands still for a second.
  await sleep(1_000);
  if ((await readScene(page)).tick === loaded.tick) {
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await waitUntil('the reloaded demo plays', () => readScene(page), (s) => s.tick > loaded.tick);
  }
}

/**
 * Press Step from inside the page on the first read of a tick at or past `from`, and return that
 * tick. Pressing from Node would add a round trip and Playwright's wait for a still button, and the
 * host keeps playing through both.
 */
function stepOnTick(page: Page, from: number): Promise<number> {
  return page.evaluate(
    ({ from, timeoutMs }) =>
      new Promise<number>((resolve, reject) => {
        const fab = (window as unknown as { __fabrico: { scene(): { tick: number } } }).__fabrico;
        const deadline = performance.now() + timeoutMs;
        const check = (): void => {
          const tick = fab.scene().tick;
          if (tick >= from) {
            const step = document.querySelector<HTMLButtonElement>('header button[aria-label="Step"]');
            if (step === null) return reject(new Error('the toolbar has no Step button'));
            step.click();
            return resolve(tick);
          }
          if (performance.now() > deadline) return reject(new Error(`the demo did not reach tick ${from} in ${timeoutMs} ms (it reads ${tick})`));
          setTimeout(check, 16);
        };
        check();
      }),
    { from, timeoutMs: WAIT_TIMEOUT_MS },
  );
}

/** Wait until two reads 250 ms apart agree on the tick, and return that read. */
async function waitHeld(page: Page): Promise<SceneRead> {
  let last = -1;
  const settled = await waitUntil(
    'the board holds still after Step',
    async () => {
      await sleep(250);
      const s = await readScene(page);
      const same = s.tick === last;
      last = s.tick;
      return { s, same };
    },
    (r) => r.same,
  );
  return settled.s;
}

/**
 * Load the demo through Examples, let it run to a hold tick, then hold it with Step and step on to
 * TOUR_TICK. Step on a running board runs one tick and freezes it where it is. Pause would not do:
 * the host drains every belt before it freezes, so a paused demo shows empty belts, and the tick it
 * stops on depends on what was in flight. When Step lands past TOUR_TICK, load the demo again and
 * hold from an earlier tick (HOLD_FROM).
 */
async function holdDemoAtTourTick(page: Page): Promise<SceneRead> {
  let before = await waitUntil('the host streams its first board', () => readScene(page), (s) => s.nodes.length > 0 && s.tick > 30);
  let held: SceneRead | null = null;
  const landed: string[] = [];
  for (const from of HOLD_FROM) {
    await loadDemo(page, before);
    const pressedOn = await stepOnTick(page, from).catch((error: unknown) => fail(`${error instanceof Error ? error.message : String(error)}.`));
    const stopped = await waitHeld(page);
    landed.push(`tick ${stopped.tick} (held from ${from}, Step pressed on ${pressedOn})`);
    if (stopped.tick <= TOUR_TICK) {
      held = stopped;
      break;
    }
    console.error(`capture:tour: the board stopped on tick ${stopped.tick}, past the tour's tick ${TOUR_TICK}; loading the demo again.`);
    before = stopped;
  }
  if (held === null) return fail(`the board stopped past the tour's tick ${TOUR_TICK} on every try: ${landed.join('; ')}.`);
  while (held.tick < TOUR_TICK) {
    const from: number = held.tick;
    await page.getByRole('button', { name: 'Step', exact: true }).click();
    held = await waitUntil(`Step moves the board on from tick ${from}`, () => readScene(page), (r) => r.tick > from);
  }
  if (held.tick !== TOUR_TICK) fail(`Step went past the tour's tick: the board reads ${held.tick}, not ${TOUR_TICK}.`);
  // Let the render clock settle on the held tick.
  await sleep(1_000);
  return held;
}

/** Click the first Factory on the board so the inspector opens on it. */
async function selectFirstFactory(page: Page, scene: SceneRead): Promise<void> {
  const factory = scene.nodes.find((n) => n.kind === FACTORY_KIND);
  if (factory === undefined) return fail('the demo board has no Factory to select for overview.png.');
  const [cx, cy] = factory.cells[0];
  const at = cellCentre(await readCamera(page), cx, cy);
  await page.mouse.click(at.x, at.y);
  const heading = page.locator('#fab-config-heading');
  await heading.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT_MS });
  const text = (await heading.textContent())?.trim();
  if (text !== 'Factory') fail(`clicking the first Factory opened the inspector on "${text}", not "Factory".`);
  await sleep(500);
}

/** The left edge, in CSS px, of the first toolbar button with visible text after the tick counter. */
async function firstLabelledButtonAfterTick(page: Page): Promise<number> {
  const x = await page.evaluate(() => {
    const counter = document.querySelector('header [title="Current sim tick"]');
    if (counter === null) return null;
    const after = counter.getBoundingClientRect().right;
    const lefts = [...document.querySelectorAll('header button')]
      .filter((b) => (b.textContent ?? '').trim() !== '')
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.left >= after)
      .map((r) => r.left)
      .sort((a, b) => a - b);
    return lefts.length > 0 ? lefts[0] : null;
  });
  if (x === null) return fail('the toolbar has no tick counter followed by a labelled button, so toolbar-file.png has no left edge.');
  return x;
}

/** The cells a machine, belt or wire covers. */
function occupiedCells(scene: SceneRead): Set<string> {
  const cells = new Set<string>();
  for (const n of scene.nodes) for (const [cx, cy] of n.cells) cells.add(`${cx},${cy}`);
  for (const b of scene.belts) for (const t of b.tiles) cells.add(`${t.cell_x},${t.cell_y}`);
  for (const w of scene.wires) for (const t of w.path) cells.add(`${t.cell_x},${t.cell_y}`);
  return cells;
}

/**
 * Zoom in at the window centre, then drag the view by PAN from a point on empty floor, and return
 * the zoom readout. Each step is checked on the camera: the wheel changes the scale, and the drag
 * moves the view by exactly the drag.
 */
async function zoomAndPan(page: Page, scene: SceneRead): Promise<string> {
  const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < WHEEL_NOTCHES; i++) {
    const before = await readCamera(page);
    await page.mouse.wheel(0, WHEEL_DELTA);
    await waitUntil(`wheel notch ${i + 1} zooms the camera in`, () => readCamera(page), (c) => c.scale > before.scale);
    await sleep(300);
  }
  // A start point on empty floor: no machine, belt or wire under it, and clear of the panels.
  const cam = await readCamera(page);
  const taken = occupiedCells(scene);
  const panels = await Promise.all(
    ['aside[data-fab-left-dock]', 'header', '[data-fab-camera-cluster]'].map((sel) => boxOf(page.locator(sel).first(), sel)),
  );
  const clear = (x: number, y: number): boolean =>
    panels.every((p) => x < p.x - 16 || x > p.x + p.width + 16 || y < p.y - 16 || y > p.y + p.height + 16);
  let start: { x: number; y: number } | null = null;
  for (let y = VIEWPORT.height - 120; y > 160 && start === null; y -= 40) {
    for (let x = VIEWPORT.width - 120; x > 280 && start === null; x -= 40) {
      const end = { x: x + PAN.dx, y: y + PAN.dy };
      const cx = Math.floor((x - cam.x) / cam.scale / CELL);
      const cy = Math.floor((y - cam.y) / cam.scale / CELL);
      if (!taken.has(`${cx},${cy}`) && clear(x, y) && clear(end.x, end.y)) start = { x, y };
    }
  }
  if (start === null) return fail('no empty floor to start the pan for camera-zoomed.png.');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + PAN.dx, start.y + PAN.dy, { steps: 12 });
  await page.mouse.up();
  const after = await waitUntil(
    'the drag moves the view',
    () => readCamera(page),
    (c) => Math.abs(c.x - (cam.x + PAN.dx)) < 0.5 && Math.abs(c.y - (cam.y + PAN.dy)) < 0.5,
  );
  if (after.scale !== cam.scale) fail(`the drag changed the zoom from ${cam.scale} to ${after.scale}.`);
  await sleep(500);
  const readout = (await page.getByTitle('Reset zoom to 100%').textContent())?.trim() ?? '';
  if (!/^\d+%$/.test(readout)) fail(`the zoom readout reads "${readout}" after the zoom, not a percentage.`);
  return readout;
}

// --- Main -----------------------------------------------------------------------

async function main(): Promise<void> {
  await refuseBusyPorts();
  mkdirSync(OUT_DIR, { recursive: true });
  let host: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  const browser = await chromium.launch({ args: GL_ARGS });
  try {
    host = startHost();
    vite = startVite();
    await waitForPort(host, HOST_PORT, 'the dev host');
    await waitForPort(vite, VITE_PORT, 'the Vite dev server');

    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const page = await context.newPage();
    const errors = watchPageErrors(page);
    await page.addInitScript((flag) => localStorage.setItem(flag, '1'), ONBOARDING_FLAG);
    await page.goto(APP_URL);
    await page.getByRole('button', { name: 'Place Factory' }).waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });

    const scene = await holdDemoAtTourTick(page);
    const tick = scene.tick;

    // overview: the whole window with the first Factory selected, so the inspector is open.
    const fitted = await readCamera(page);

    // overview, inspector, palette and the two toolbar crops, with the first Factory selected.
    await selectFirstFactory(page, scene);
    await take(page, errors, { file: 'overview.png', kind: 'full' }, tick);
    const inspector = page.locator('[aria-labelledby="fab-config-heading"]');
    await take(page, errors, { file: 'inspector.png', kind: 'crop', box: wholePx(await boxOf(inspector, 'the inspector')) }, tick);
    const palette = page.locator('aside[data-fab-left-dock]');
    await take(page, errors, { file: 'palette.png', kind: 'crop', box: wholePx(await boxOf(palette, 'the palette')) }, tick);
    const header = await boxOf(page.locator('header').first(), 'the toolbar');
    const redo = await boxOf(page.locator('button[aria-label="Redo"]'), 'the Redo button');
    const runBox = { x: header.x, y: header.y, width: redo.x + redo.width + TOOLBAR_MARGIN - header.x, height: header.height };
    await take(page, errors, { file: 'toolbar-run.png', kind: 'crop', box: wholePx(runBox) }, tick);
    const firstLabelled = await firstLabelledButtonAfterTick(page);
    const fileBox = { x: firstLabelled - TOOLBAR_MARGIN, y: header.y, width: header.x + header.width - (firstLabelled - TOOLBAR_MARGIN), height: header.height };
    await take(page, errors, { file: 'toolbar-file.png', kind: 'crop', box: wholePx(fileBox) }, tick);

    // camera-default: nothing selected, the view the board loaded with.
    await page.keyboard.press('Escape');
    await page.locator('#fab-config-heading').waitFor({ state: 'detached', timeout: WAIT_TIMEOUT_MS });
    const now = await readCamera(page);
    if (now.x !== fitted.x || now.y !== fitted.y || now.scale !== fitted.scale) {
      fail(`the camera moved before camera-default.png: it read ${JSON.stringify(fitted)} after load and ${JSON.stringify(now)} now.`);
    }
    await sleep(500);
    await take(page, errors, { file: 'camera-default.png', kind: 'full' }, tick);

    // camera-zoomed and camera-controls: two wheel notches at the window centre, then a left drag
    // on empty floor with no tool armed.
    const readout = await zoomAndPan(page, await readScene(page));
    await take(page, errors, { file: 'camera-zoomed.png', kind: 'full' }, tick);
    const cluster = page.locator('[data-fab-camera-cluster]');
    await take(page, errors, { file: 'camera-controls.png', kind: 'crop', box: wholePx(await boxOf(cluster, 'the camera cluster')) }, tick);

    console.log(`CAPTURE_TOUR files=8 tick=${tick} readout=${readout} dir=site/src/assets/tour`);
  } finally {
    await browser.close().catch(() => undefined);
    killGroup(vite);
    killGroup(host);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof CaptureError ? error.message : `capture:tour: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
}
