// measure-real-app.ts - measures the running desktop app with the board capture set's own measurer.
//
// The capture set (`e2e-live/board.capture.ts`) runs in Chromium. The app people install runs in
// WebKitGTK. This tool takes the same captures from the real binary, so the two engines can be
// compared cell by cell: for each zoom it sets the camera through the shipped controls, holds the
// render clock, reads the capture facts, captures the X display's root window, crops it to the
// webview and runs the same measuring and grading functions the capture set's grading project uses
// (`boardMeasure.ts`, with `{ dpr, aa: 'shipped', zoom }` as the cell). Where the board overflows the
// webview it pans through the same tile plan the capture set uses (`tilePlan`), so every subject is
// graded from a tile that holds it whole, as in CI.
//
// IT NEVER LAUNCHES THE APP. Start the self-contained binary yourself, on a private X display (an
// Xvfb server, with the GTK backend forced to X11 so no window opens anywhere else), with WebKit's
// inspector server bound to 127.0.0.1 on a free port (the WebKitGTK environment variable that turns
// on its HTTP inspector). While that variable is set, any local process can run script in the page,
// so set it only for the length of a walk, and never commit a launcher that sets it.
//
// HOW IT TALKS TO THE APP. Through the inspector's WebSocket, with `Runtime.evaluate` wrapped in
// `Target.sendMessageToTarget` (the page's Runtime domain is only reachable through Target). The
// in-page functions it sends (`resetZoomInPage`, `ctrlWheelInPage`, `panWheelInPage`,
// `collectCaptureFacts`) are self-contained, so their source text is sent as is. The only writes it
// makes are the ones a user makes: the toolbar's Pause and Play, the zoom reset, wheels on the
// board canvas, and the render-clock pin the capture set also uses.
//
// HOW IT REACHES THE MEASURER. The support files use extensionless imports and pull SVG assets in
// through Vite's `?raw` suffix, which plain Node can't load, so they are loaded through a Vite
// server in middleware mode (no port, no HMR socket) and the server is closed at the end.
//
// Usage, from frontend/:
//   node scripts/measure-real-app.ts --port <inspector port> --display <:N> --origin <x,y> \
//     --zooms <list> --out <dir> [--reload] [--camera-from <manifest.json>]
//
//   --origin  the webview's top-left corner in the root window, in device px
//   --zooms   comma-separated: `boot`, `fullscreen-boot`, numbers, or `all` for the capture set's zooms
//   --reload  reload the page first, so the board's own fit runs at the window's current size
//   --camera-from <manifest.json>
//             after each numbered zoom lands, pan so tile 0's camera equals that capture-set
//             manifest's tile 0 camera at the same zoom, and take the manifest's tiles in place
//             of this page's own tile plan. Where the two engines' fits or chrome sizes differ,
//             the numbered zooms and the tiles otherwise sit at different pans, and a hard edge
//             then lands on a different sub-pixel phase; matching the cameras leaves only the
//             engine's own drawing as a difference. The boot zoom is always the app's own fit.
//
// Writes `<out>/z-<zoom>-t<tile>.png` (the root window), `<out>/z-<zoom>-t<tile>.facts.json` and
// `<out>/results.json`: one entry per zoom with the camera, ratio, backing and client size, the live
// WebGL attributes, a verdict per property and every tile's measurements.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { createServer, type ViteDevServer } from 'vite';
import type * as BoardMeasure from '../e2e-live/support/boardMeasure';
import type * as CaptureFactsModule from '../e2e-live/support/captureFacts';
import type * as CaptureMatrix from '../e2e-live/support/captureMatrix';
import type * as CaptureZoom from '../e2e-live/support/captureZoom';
import type * as Geometry from '../shared/geometry';

const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function usage(why: string): never {
  console.error(`measure-real-app: ${why}`);
  console.error('usage: node scripts/measure-real-app.ts --port <n> --display <:N> --origin <x,y> --zooms <list> --out <dir> [--reload] [--camera-from <manifest.json>]');
  process.exit(2);
}

const port = Number(flag('port'));
const display = flag('display') ?? '';
const originArg = (flag('origin') ?? '').split(',').map(Number);
const zoomsArg = flag('zooms') ?? '';
const outDir = resolve(flag('out') ?? '');
const reload = argv.includes('--reload');
const cameraFrom = flag('camera-from');
if (!Number.isInteger(port) || port <= 0) usage('--port must be a positive integer');
if (!/^:\d+$/.test(display)) usage('--display must look like :N');
if (originArg.length !== 2 || !originArg.every((n) => Number.isInteger(n) && n >= 0)) usage('--origin must be two whole numbers, x,y');
if (zoomsArg === '') usage('--zooms is required');
if (flag('out') === undefined) usage('--out is required');
const origin = { x: originArg[0], y: originArg[1] };

/** How long one inspector call may take before the walk stops. */
const EVAL_TIMEOUT_MS = 20_000;
/** The spacing of the two camera reads that must agree before a capture. */
const SETTLE_GAP_MS = 250;
/** How long the camera, the tick and the render loop each get to settle. */
const SETTLE_LIMIT_MS = 15_000;
/** How close a pan must land to where the tile plan put the board, in CSS px. */
const PAN_TOLERANCE = 1e-6;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The inspector client
// ---------------------------------------------------------------------------

interface Inspector {
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

async function connectInspector(): Promise<Inspector> {
  const listing = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const path = /\/socket\/\d+\/\d+\/WebPage/.exec(listing)?.[0];
  if (path === undefined) throw new Error(`no WebPage socket listed at http://127.0.0.1:${port}/`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  let targetId: string | null = null;
  let nextOuter = 1;
  let nextInner = 100;
  const pending = new Map<number, (inner: { error?: unknown; result: { wasThrown?: boolean; result: { value?: unknown; description?: string } } }) => void>();
  let targetReady: (id: string) => void = () => undefined;
  const ready = new Promise<string>((r) => {
    targetReady = r;
  });
  ws.onmessage = (m: MessageEvent) => {
    const msg = JSON.parse(String(m.data));
    if (msg.method === 'Target.targetCreated' && targetId === null) {
      targetId = msg.params.targetInfo.targetId as string;
      targetReady(targetId);
    }
    if (msg.method === 'Target.dispatchMessageFromTarget') {
      const inner = JSON.parse(msg.params.message);
      const p = pending.get(inner.id);
      if (p !== undefined) {
        pending.delete(inner.id);
        p(inner);
      }
    }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('inspector WebSocket error'));
  });
  await Promise.race([ready, sleep(EVAL_TIMEOUT_MS).then(() => Promise.reject(new Error('no Target.targetCreated from the inspector')))]);
  return {
    evaluate<T>(expression: string): Promise<T> {
      return new Promise<T>((res, rej) => {
        const id = nextInner++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`Runtime.evaluate timed out: ${expression.slice(0, 80)}`));
        }, EVAL_TIMEOUT_MS);
        pending.set(id, (inner) => {
          clearTimeout(timer);
          if (inner.error !== undefined) return rej(new Error(JSON.stringify(inner.error)));
          if (inner.result.wasThrown === true) return rej(new Error(`the page threw: ${inner.result.result.description ?? JSON.stringify(inner.result.result)}`));
          res(inner.result.result.value as T);
        });
        ws.send(
          JSON.stringify({
            id: nextOuter++,
            method: 'Target.sendMessageToTarget',
            params: { targetId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }) },
          }),
        );
      });
    },
    close: () => ws.close(),
  };
}

/** The expression that calls a self-contained in-page function with JSON arguments. */
function call(fn: (...a: never[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

// ---------------------------------------------------------------------------
// In-page reads and writes
// ---------------------------------------------------------------------------

interface Camera {
  x: number;
  y: number;
  scale: number;
}

const CAMERA = 'window.__fabrico.camera()';
const TICK = 'window.__fabrico.scene().tick';
const TICKER_TIME = 'window.__fabrico.tickerTime()';
const READY = `(() => { const h = window.__fabrico; if (!h || typeof h.scene !== 'function') return 0; return h.scene().nodes.length; })()`;
const TRANSPORT_LABEL = `(() => { const b = Array.from(document.querySelectorAll('button')).find((e) => /^(Play|Pause)$/.test(e.getAttribute('aria-label') ?? '')); return b ? b.getAttribute('aria-label') : null; })()`;
const TRANSPORT_CLICK = `(() => { const b = Array.from(document.querySelectorAll('button')).find((e) => /^(Play|Pause)$/.test(e.getAttribute('aria-label') ?? '')); if (!b) throw new Error('no Play/Pause control in the toolbar'); b.click(); return b.getAttribute('aria-label'); })()`;
const VIEW = '({ dpr: window.devicePixelRatio, inner: { width: window.innerWidth, height: window.innerHeight } })';

const sameCamera = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.scale === b.scale;

/** Wait until two reads `gap` ms apart agree, and answer the agreed value. */
async function settled<T>(read: () => Promise<T>, same: (a: T, b: T) => boolean, what: string, gap = SETTLE_GAP_MS): Promise<T> {
  const until = Date.now() + SETTLE_LIMIT_MS;
  let last = await read();
  for (;;) {
    await sleep(gap);
    const now = await read();
    if (same(last, now)) return now;
    if (Date.now() > until) throw new Error(`${what} did not settle within ${SETTLE_LIMIT_MS} ms (last two reads ${JSON.stringify(last)} and ${JSON.stringify(now)})`);
    last = now;
  }
}

/**
 * Render health on a held board: the ticker finishes new frames while the tick stays put. A dead
 * renderer would leave every model read correct and the capture stale, so this runs before each one.
 */
async function expectRenderLoopAlive(page: Inspector, heldTick: number, label: string): Promise<void> {
  const t0 = await page.evaluate<number>(TICKER_TIME);
  const until = Date.now() + SETTLE_LIMIT_MS;
  const seen = new Set<number>([t0]);
  while (seen.size < 3) {
    if (Date.now() > until) throw new Error(`${label}: the render loop did not finish two new frames within ${SETTLE_LIMIT_MS} ms`);
    await sleep(20);
    seen.add(await page.evaluate<number>(TICKER_TIME));
  }
  const tick = await page.evaluate<number>(TICK);
  if (tick !== heldTick) throw new Error(`${label}: the board moved off the held tick (${heldTick} to ${tick})`);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Capture the X root window to `file` and answer it decoded. */
function captureRoot(file: string): { width: number; height: number; data: Uint8Array } {
  const r = spawnSync('import', ['-window', 'root', '-display', display, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`import -window root failed (exit ${r.status}): ${r.stderr}`);
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

/** The webview's part of a root capture: `width` by `height` device px from `origin`. */
function crop(image: { width: number; height: number; data: Uint8Array }, width: number, height: number) {
  const w = Math.min(width, image.width - origin.x);
  const h = Math.min(height, image.height - origin.y);
  if (w <= 0 || h <= 0) throw new Error(`the origin ${origin.x},${origin.y} lies outside the ${image.width}x${image.height} root capture`);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((origin.y + y) * image.width + origin.x) * 4;
    data.set(image.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface Verdict {
  /** True where a requirement promises the property at this zoom (the capture set grades it). */
  graded: boolean;
  pass: boolean;
  offenders: string[];
  unmeasured: string[];
  explain: string;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const vite: ViteDevServer = await createServer({
    root: FRONTEND_DIR,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  let page: Inspector | null = null;
  let pinned = false;
  let pausedHere = false;
  try {
    const bm = (await vite.ssrLoadModule('/e2e-live/support/boardMeasure.ts')) as typeof BoardMeasure;
    const cf = (await vite.ssrLoadModule('/e2e-live/support/captureFacts.ts')) as typeof CaptureFactsModule;
    const cm = (await vite.ssrLoadModule('/e2e-live/support/captureMatrix.ts')) as typeof CaptureMatrix;
    const cz = (await vite.ssrLoadModule('/e2e-live/support/captureZoom.ts')) as typeof CaptureZoom;
    const geo = (await vite.ssrLoadModule('/shared/geometry.ts')) as typeof Geometry;

    const zooms: CaptureMatrix.CaptureZoom[] =
      zoomsArg === 'all'
        ? [...cm.CAPTURE_ZOOMS]
        : zoomsArg.split(',').map((t) => {
            if (t === 'boot') return 'boot';
            if (t === 'fullscreen-boot') return cm.FULLSCREEN_BOOT_ZOOM;
            const n = Number(t);
            if (!Number.isFinite(n) || n <= 0) usage(`unknown zoom ${JSON.stringify(t)}`);
            return n;
          });

    const matchCameras: CaptureMatrix.CaptureManifest | null =
      cameraFrom === undefined ? null : (JSON.parse(readFileSync(resolve(cameraFrom), 'utf8')) as CaptureMatrix.CaptureManifest);

    page = await connectInspector();
    if (reload) {
      await page.evaluate('(location.reload(), true)');
      page.close();
      await sleep(3000);
      page = await connectInspector();
    }
    const p = page;
    await settled(() => p.evaluate<number>(READY), (a, b) => a > 0 && a === b, 'the board loading');
    const bootCamera = await settled(() => p.evaluate<Camera>(CAMERA), sameCamera, 'the boot camera');

    // Pause from the toolbar and hold the render clock on the tick the host stopped on.
    if ((await p.evaluate<string | null>(TRANSPORT_LABEL)) === 'Pause') {
      await p.evaluate(TRANSPORT_CLICK);
      pausedHere = true;
    }
    if ((await p.evaluate<string | null>(TRANSPORT_LABEL)) !== 'Play') throw new Error('the toolbar does not offer Play after pausing');
    const pausedAt = await settled(() => p.evaluate<number>(TICK), (a, b) => a === b, 'the host tick', 200);
    await p.evaluate(`window.__fabrico.pinClock(${pausedAt})`);
    pinned = true;

    const view = await p.evaluate<{ dpr: number; inner: { width: number; height: number } }>(VIEW);
    const viewport = view.inner;
    const cropW = Math.round(viewport.width * view.dpr);
    const cropH = Math.round(viewport.height * view.dpr);
    console.log(`WALK dpr=${view.dpr} inner=${viewport.width}x${viewport.height} crop=${cropW}x${cropH} at ${origin.x},${origin.y} boot scale=${bootCamera.scale} paused at tick ${pausedAt}`);

    const results: unknown[] = [];
    for (const zoom of zooms) {
      const zid = cm.zoomId(zoom);
      let zoomCamera: Camera;
      if (zoom === 'boot') {
        zoomCamera = await p.evaluate<Camera>(CAMERA);
        if (!sameCamera(zoomCamera, bootCamera)) throw new Error(`zoom=boot: the camera is no longer the boot camera; ask for boot first`);
      } else {
        await p.evaluate(call(cz.resetZoomInPage));
        let cam = await settled(() => p.evaluate<Camera>(CAMERA), sameCamera, `zoom=${zid}: the reset`);
        const nodes = await p.evaluate<[number, number][][]>('window.__fabrico.scene().nodes.map((n) => n.cells)');
        const cells = nodes.flat();
        const xs = cells.map(([x]) => x);
        const ys = cells.map(([, y]) => y);
        const wx = ((Math.min(...xs) + Math.max(...xs) + 1) * geo.CELL) / 2;
        const wy = ((Math.min(...ys) + Math.max(...ys) + 1) * geo.CELL) / 2;
        const at = { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
        for (let wheel = 0; wheel < 2 && Math.abs(cam.scale - zoom) > cz.ZOOM_TOLERANCE; wheel++) {
          await p.evaluate(call(cz.ctrlWheelInPage, { x: at.x, y: at.y, dy: cz.wheelDeltaFor(zoom, cam.scale) }));
          cam = await settled(() => p.evaluate<Camera>(CAMERA), sameCamera, `zoom=${zid}: the wheel`);
        }
        if (Math.abs(cam.scale - zoom) > cz.ZOOM_TOLERANCE) throw new Error(`zoom=${zid}: the camera reads ${cam.scale} after a reset and two wheels`);
        const want = matchCameras?.entries.find((e) => e.cell.zoom === zoom && e.tile === 0)?.camera;
        if (matchCameras !== null && want === undefined) throw new Error(`zoom=${zid}: --camera-from has no tile 0 at this zoom`);
        if (want !== undefined) {
          // A pan wheel moves the board by minus its delta (the pan branch of the wheel handler).
          await p.evaluate(call(cz.panWheelInPage, { dx: -(want.x - cam.x), dy: -(want.y - cam.y) }));
          cam = await settled(() => p.evaluate<Camera>(CAMERA), sameCamera, `zoom=${zid}: the matching pan`);
          const off = Math.max(Math.abs(cam.x - want.x), Math.abs(cam.y - want.y));
          if (off > PAN_TOLERANCE) throw new Error(`zoom=${zid}: the matching pan landed ${off} CSS px off the manifest's camera`);
        }
        zoomCamera = cam;
      }

      let plan: CaptureZoom.TileOffset[] = [{ dx: 0, dy: 0 }];
      let atTile: CaptureZoom.TileOffset = { dx: 0, dy: 0 };
      const records: (BoardMeasure.TileRecord & { tile: number; png: string; camera: Camera })[] = [];
      let first: CaptureFactsModule.CaptureFacts | null = null;
      for (let tile = 0; tile < plan.length; tile++) {
        const label = `zoom=${zid} tile=${tile}`;
        let camera = zoomCamera;
        if (tile > 0) {
          const want = plan[tile];
          await p.evaluate(call(cz.panWheelInPage, { dx: -(want.dx - atTile.dx), dy: -(want.dy - atTile.dy) }));
          camera = await settled(() => p.evaluate<Camera>(CAMERA), sameCamera, `${label}: the pan`);
          atTile = want;
          const off = Math.max(Math.abs(camera.x - (zoomCamera.x + want.dx)), Math.abs(camera.y - (zoomCamera.y + want.dy)));
          if (camera.scale !== zoomCamera.scale || off > PAN_TOLERANCE) throw new Error(`${label}: the pan landed ${off} CSS px off the tile plan, scale ${camera.scale}`);
        }
        await expectRenderLoopAlive(p, pausedAt, label);
        const png = `z-${zid}-t${tile}.png`;
        const root = captureRoot(join(outDir, png));
        const facts = await p.evaluate<CaptureFactsModule.CaptureFacts>(call(cf.collectCaptureFacts));
        if (!sameCamera(facts.camera, camera)) throw new Error(`${label}: the camera moved between the pan and the capture`);
        if (facts.tick !== pausedAt) throw new Error(`${label}: the board left the held tick`);
        writeFileSync(join(outDir, png.replace(/\.png$/, '.facts.json')), `${JSON.stringify(facts)}\n`);
        const image = crop(root, cropW, cropH);
        if (tile === 0) {
          first = facts;
          const tiles = matchCameras?.entries.filter((e) => e.cell.zoom === zoom).sort((a, b) => a.tile - b.tile);
          plan =
            tiles === undefined || zoom === 'boot'
              ? cz.tilePlan(facts, viewport)
              : tiles.map((e) => ({ dx: e.camera.x - tiles[0].camera.x, dy: e.camera.y - tiles[0].camera.y }));
        }
        records.push({ tile, png, camera: facts.camera, ...bm.measureTileProperties(image, facts) });
      }
      if (first === null) throw new Error(`zoom=${zid}: no tile captured`);

      const cell: CaptureMatrix.CaptureCell = { dpr: first.dpr, aa: 'shipped', zoom };
      const verdicts: Record<string, Verdict> = {};
      for (const property of cm.PROPERTY_IDS) {
        const g = bm.gradeCell(property, cell, records);
        verdicts[property] = {
          graded: cm.propertyGradedAt(property, zoom),
          pass: g.offenders.length === 0,
          offenders: g.offenders.map((o) => o.key),
          unmeasured: g.offenders.filter((o) => o.unmeasured).map((o) => o.key),
          explain: g.explain,
        };
      }
      results.push({
        zoom,
        zoomId: zid,
        bootScale: bootCamera.scale,
        camera: zoomCamera,
        cameraMatched: matchCameras !== null && zoom !== 'boot',
        dpr: first.dpr,
        backing: first.backing,
        client: first.client,
        inner: viewport,
        gl: first.gl,
        tick: first.tick,
        tiles: records.length,
        overflows: records.length > 1,
        verdicts,
        measurements: records,
      });
      writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
      const summary = cm.PROPERTY_IDS.map((pr) => `${pr}=${verdicts[pr].pass ? 'pass' : `fail(${verdicts[pr].offenders.length})`}${verdicts[pr].graded ? '' : '*'}`).join(' ');
      console.log(`WALK_ZOOM ${zid} scale=${zoomCamera.scale} tiles=${records.length}${records.length > 1 ? ' (board overflows the webview; tiled)' : ''} ${summary}`);
    }
    console.log(`WALK_DONE ${results.length} zooms written to ${join(outDir, 'results.json')} (* = not graded at that zoom by the capture set)`);
  } finally {
    if (page !== null) {
      const p = page;
      if (pinned) await p.evaluate('window.__fabrico.pinClock(null)').catch(() => undefined);
      if (pausedHere && (await p.evaluate<string | null>(TRANSPORT_LABEL).catch(() => null)) === 'Play') await p.evaluate(TRANSPORT_CLICK).catch(() => undefined);
      p.close();
    }
    await vite.close();
  }
}

main().catch((err: unknown) => {
  console.error(`measure-real-app: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
